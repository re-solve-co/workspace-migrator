const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3050;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_DIR = path.join(__dirname, 'reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Current migration job state
let currentJob = {
  running: false,
  process: null,
  jobType: 'idle', // 'copy', 'dry-run', 'sync'
  source: '',
  destination: '',
  clientName: '',
  startTime: null,
  endTime: null,
  stats: {
    bytes: 0,
    totalBytes: 0,
    speed: 0,
    transfers: 0,
    totalTransfers: 0,
    percentage: 0,
    eta: 0,
    transferring: [],
    errors: 0,
    lastLog: ''
  },
  logs: [],
  reportFile: null
};

// Connected SSE clients for real-time live streaming
let sseClients = [];

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(payload);
    } catch (e) {
      // client disconnected
    }
  });
}

// Get configured rclone remotes
function getConfiguredRemotes() {
  try {
    const output = execSync('rclone listremotes', { encoding: 'utf8' }).trim();
    if (!output) return [];
    return output.split('\n').map(line => line.replace(':', '').trim()).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// Get remote details from rclone config dump
function getRemoteDetails() {
  try {
    const raw = execSync('rclone config dump', { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

// Active OAuth process tracking
let currentAuthProc = null;

// Cache for remote user information (emails, names, pictures)
const remoteUserCache = {};

async function resolveRemoteUserInfo(name, details) {
  if (remoteUserCache[name]) return remoteUserCache[name];

  if (details && details.type === 'drive' && details.token) {
    try {
      const tokenObj = typeof details.token === 'string' ? JSON.parse(details.token) : details.token;
      if (tokenObj && tokenObj.access_token) {
        const res = await fetch('https://www.googleapis.com/drive/v2/about', {
          headers: { Authorization: `Bearer ${tokenObj.access_token}` },
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.user && data.user.emailAddress) {
            remoteUserCache[name] = {
              email: data.user.emailAddress,
              displayName: data.user.displayName || data.name || name,
              picture: data.user.picture?.url || ''
            };
            return remoteUserCache[name];
          }
        }
      }
    } catch (e) {
      // Fallback gracefully on background fetch error
    }
  }

  return {
    email: details?.client_id || details?.user || '',
    displayName: name,
    picture: ''
  };
}

// MIME types for serving static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = reqUrl.pathname;

  // CORS headers for clean client-side interaction
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API: System Status & Remotes ---
  if (pathname === '/api/status' && req.method === 'GET') {
    const remotes = getConfiguredRemotes();
    const remoteDetails = getRemoteDetails();

    const enrichedRemotes = await Promise.all(remotes.map(async (name) => {
      const userInfo = await resolveRemoteUserInfo(name, remoteDetails[name]);
      return {
        name,
        type: remoteDetails[name]?.type || 'unknown',
        email: userInfo.email,
        displayName: userInfo.displayName,
        picture: userInfo.picture,
        user: userInfo.email || name
      };
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: currentJob.running,
      job: {
        jobType: currentJob.jobType,
        clientName: currentJob.clientName,
        source: currentJob.source,
        destination: currentJob.destination,
        startTime: currentJob.startTime,
        endTime: currentJob.endTime,
        stats: currentJob.stats,
        reportFile: currentJob.reportFile
      },
      remotes: enrichedRemotes
    }));
    return;
  }

  // --- API: Live Server-Sent Events (SSE) Stream ---
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 1000\n\n');
    sseClients.push(res);

    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // --- API: Connect New Cloud Account (Triggers Browser OAuth) ---
  if (pathname === '/api/connect' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { remoteName, provider } = JSON.parse(body);
        if (!remoteName || !provider) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'remoteName and provider are required' }));
          return;
        }

        // Clean up any lingering auth process or port conflict
        if (currentAuthProc) {
          try { currentAuthProc.kill('SIGTERM'); } catch (e) {}
          currentAuthProc = null;
        }
        try {
          execSync('kill $(lsof -t -i :53682) 2>/dev/null || true');
        } catch (e) {}

        let args = ['config', 'create', remoteName];
        if (provider === 'google_drive') {
          args.push('drive', 'scope', 'drive', 'config_is_local', 'true');
        } else if (provider === 'onedrive') {
          args.push('onedrive', 'config_is_local', 'true');
        } else if (provider === 'dropbox') {
          args.push('dropbox', 'config_is_local', 'true');
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unsupported provider: ${provider}` }));
          return;
        }

        console.log(`[OAuth Spawning] rclone ${args.join(' ')}`);
        const authProc = spawn('rclone', args);
        currentAuthProc = authProc;

        let authUrlSent = false;
        let responseSent = false;

        const sendAuthResponse = (authUrl) => {
          if (!responseSent) {
            responseSent = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              authUrl: authUrl || null,
              message: `Authorization started for ${remoteName}.`
            }));
          }
        };

        const handleAuthOutput = (data) => {
          const text = data.toString();
          console.log(`[OAuth Log] ${text.trim()}`);
          
          const match = text.match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[^\s]+/);
          if (match && !authUrlSent) {
            authUrlSent = true;
            const authUrl = match[0];
            console.log(`[OAuth AuthURL Detected] ${authUrl}`);
            broadcastSSE({ type: 'oauth_url', authUrl, remoteName });
            sendAuthResponse(authUrl);
          }
        };

        authProc.stdout.on('data', handleAuthOutput);
        authProc.stderr.on('data', handleAuthOutput);

        authProc.on('close', (code) => {
          console.log(`[OAuth Finished] Remote "${remoteName}" exited with code ${code}`);
          currentAuthProc = null;
          if (code === 0) {
            broadcastSSE({ type: 'account_connected', remoteName });
          } else {
            broadcastSSE({ type: 'oauth_error', remoteName, code });
          }
          if (!responseSent) {
            sendAuthResponse(null);
          }
        });

        authProc.on('error', (err) => {
          console.error(`[OAuth Process Error]`, err);
          currentAuthProc = null;
          if (!responseSent) {
            responseSent = true;
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });

        // Fallback response if URL not found within 2 seconds
        setTimeout(() => {
          if (!responseSent) {
            sendAuthResponse(null);
          }
        }, 2000);

      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API: Delete / Disconnect Remote ---
  if (pathname === '/api/remotes/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { remoteName } = JSON.parse(body);
        execSync(`rclone config delete "${remoteName}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Disconnected ${remoteName}` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API: Demo / Test Migration Simulation ---
  if (pathname === '/api/migrate/demo' && req.method === 'POST') {
    if (currentJob.running) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A job is already running!' }));
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFilename = `Audit_Report_Demo_Acme_Corp_${timestamp}.csv`;
    const reportFilePath = path.join(REPORTS_DIR, reportFilename);

    fs.writeFileSync(reportFilePath, 'Timestamp,Action,Status,File_Path,Size_Bytes,Error_Message\n');

    currentJob = {
      running: true,
      process: null,
      jobType: 'demo',
      clientName: 'Demo Client (Acme Corp)',
      source: 'OneDrive_Demo:/Company_Archive',
      destination: 'Workspace_Demo:/Shared Drives/Finance & Ops',
      startTime: new Date().toISOString(),
      endTime: null,
      stats: {
        bytes: 0,
        totalBytes: 5242880000, // 5 GB
        speed: 98500000, // ~98 MB/s
        transfers: 0,
        totalTransfers: 1420,
        percentage: 0,
        eta: 10,
        transferring: [],
        errors: 0,
        lastLog: 'Connected to Cloud Backbone. Turbo High-File-Count mode active...'
      },
      logs: [],
      reportFile: reportFilename
    };

    const sampleFiles = [
      'Financials/2026_Q3_Balance_Sheet.xlsx',
      'Marketing/Keynote_Launch_Video.mp4',
      'Contracts/Enterprise_Client_Master_Agreement.pdf',
      'Operations/Warehouse_Logistics_Catalog.csv',
      'Brand/High_Res_Logos_Vector_Pack.zip',
      'Legal/Board_Resolution_Minutes_2026.docx',
      'Engineering/Architecture_Blueprints_v4.png',
      'HR/Employee_Handbook_2026_Final.pdf'
    ];

    let step = 0;
    const maxSteps = 10;
    const interval = setInterval(() => {
      step++;
      const pct = Math.min(100, Math.round((step / maxSteps) * 100));
      currentJob.stats.percentage = pct;
      currentJob.stats.bytes = Math.round((pct / 100) * currentJob.stats.totalBytes);
      currentJob.stats.transfers = Math.round((pct / 100) * currentJob.stats.totalTransfers);
      currentJob.stats.eta = Math.max(0, maxSteps - step);
      currentJob.stats.speed = 95000000 + Math.round(Math.random() * 15000000);

      const activeFile = sampleFiles[(step - 1) % sampleFiles.length];
      currentJob.stats.lastLog = `Migrated: ${activeFile}`;
      currentJob.stats.transferring = [
        { name: activeFile, size: 52428800, bytes: 45000000, percentage: 85, speed: currentJob.stats.speed },
        { name: sampleFiles[step % sampleFiles.length], size: 104857600, bytes: 62000000, percentage: 60, speed: currentJob.stats.speed * 0.9 }
      ];

      // Append to CSV audit log
      const csvRow = `"${new Date().toISOString()}","COPY","SUCCESS","${activeFile}","${52428800}",""\n`;
      fs.appendFileSync(reportFilePath, csvRow);

      broadcastSSE({ type: 'stats', stats: currentJob.stats });

      if (step >= maxSteps) {
        clearInterval(interval);
        currentJob.running = false;
        currentJob.endTime = new Date().toISOString();
        currentJob.stats.transferring = [];
        currentJob.stats.percentage = 100;
        broadcastSSE({
          type: 'completed',
          success: true,
          reportFile: reportFilename,
          stats: currentJob.stats
        });
      }
    }, 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Demo simulation started' }));
    return;
  }

  // --- API: List Remote Folders / Files ---
  if (pathname === '/api/browse' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { remote, path: subPath = '' } = JSON.parse(body);
        const target = subPath ? `${remote}:${subPath}` : `${remote}:`;
        exec(`rclone lsd "${target}" --max-depth 1`, { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ folders: [], error: stderr || err.message }));
            return;
          }
          // Parse rclone lsd lines: e.g. "       -1 2026-03-12 10:00:00        -1 FolderName"
          const folders = stdout.split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
              const parts = line.split(/\s+/);
              return parts.slice(4).join(' ');
            });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ folders }));
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API: Start Migration ---
  if (pathname === '/api/migrate/start' && req.method === 'POST') {
    if (currentJob.running) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'A migration job is already running!' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const {
          sourceRemote,
          sourcePath = '',
          destRemote,
          destPath = '',
          mode = 'copy', // 'copy', 'dry-run', 'sync'
          clientName = 'Migration Client',
          turboMode = true
        } = JSON.parse(body);

        if (!sourceRemote || !destRemote) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Source and Destination remotes are required' }));
          return;
        }

        const source = sourcePath ? `${sourceRemote}:${sourcePath}` : `${sourceRemote}:`;
        const dest = destPath ? `${destRemote}:${destPath}` : `${destRemote}:`;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportFilename = `Audit_Report_${clientName.replace(/\s+/g, '_')}_${timestamp}.csv`;
        const reportFilePath = path.join(REPORTS_DIR, reportFilename);

        // Initialize CSV report with professional header
        fs.writeFileSync(reportFilePath, 'Timestamp,Action,Status,File_Path,Size_Bytes,Error_Message\n');

        // Reset job state
        currentJob = {
          running: true,
          process: null,
          jobType: mode,
          clientName,
          source,
          destination: dest,
          startTime: new Date().toISOString(),
          endTime: null,
          stats: {
            bytes: 0,
            totalBytes: 0,
            speed: 0,
            transfers: 0,
            totalTransfers: 0,
            percentage: 0,
            eta: 0,
            transferring: [],
            errors: 0,
            lastLog: 'Initializing high-speed migration engine...'
          },
          logs: [],
          reportFile: reportFilename
        };

        // Construct high-performance arguments
        const actionCommand = mode === 'sync' ? 'sync' : 'copy';
        const args = [
          actionCommand,
          source,
          dest,
          '--stats=1s',
          '--use-json-log',
          '--log-level=INFO'
        ];

        if (mode === 'dry-run') {
          args.push('--dry-run');
        }

        // ⚡ TURBO HIGH-FILE-COUNT ENGINE PRESETS:
        if (turboMode) {
          args.push(
            '--fast-list',                  // Bulk directory traversal (dramatically faster for 10k+ files)
            '--transfers=8',                // 8 concurrent transfers
            '--checkers=16',                // 16 parallel file checkers
            '--tpslimit=12',                // Rate limiter to prevent Google/Microsoft 403 / 429 locks
            '--drive-chunk-size=64M',       // Efficient upload chunking
            '--server-side-across-configs', // Instant server-side copy across accounts
            '--drive-acknowledge-abuse',    // Do not stall on flagged files
            '--retries=2',                  // Max 2 passes (prevents 30-min stall on deleted 404 files)
            '--retries-sleep=2s',           // Instant 2s retry interval instead of minutes of backoff
            '--low-level-retries=3'         // Fast recovery on socket drops
          );
        }

        console.log(`[Migration Started] rclone ${args.join(' ')}`);

        const proc = spawn('rclone', args);
        currentJob.process = proc;

        // Parse rclone JSON log stream for live stats and audit tracking
        let buffer = '';
        proc.stderr.on('data', data => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep last incomplete line

          lines.forEach(line => {
            if (!line.trim()) return;
            try {
              const entry = JSON.parse(line);
              
              // Handle periodic stats emission
              if (entry.stats) {
                const s = entry.stats;
                currentJob.stats.bytes = s.bytes || 0;
                currentJob.stats.totalBytes = s.totalBytes || 0;
                currentJob.stats.speed = s.speed || 0;
                currentJob.stats.transfers = s.transfers || 0;
                currentJob.stats.totalTransfers = s.totalTransfers || 0;
                currentJob.stats.errors = s.errors || 0;
                currentJob.stats.eta = s.eta || 0;

                if (s.totalBytes > 0) {
                  currentJob.stats.percentage = Math.min(100, Math.round((s.bytes / s.totalBytes) * 100));
                } else if (s.totalTransfers > 0) {
                  currentJob.stats.percentage = Math.min(100, Math.round((s.transfers / s.totalTransfers) * 100));
                }

                if (s.transferring && Array.isArray(s.transferring)) {
                  currentJob.stats.transferring = s.transferring.map(t => ({
                    name: t.name,
                    size: t.size,
                    bytes: t.bytes,
                    percentage: t.percentage,
                    speed: t.speed
                  }));
                }

                broadcastSSE({ type: 'stats', stats: currentJob.stats });
              }

              // Handle individual file audit events
              if (entry.msg && entry.object) {
                currentJob.stats.lastLog = `${entry.msg}: ${entry.object}`;
                const csvRow = `"${new Date().toISOString()}","${entry.level}","${entry.msg}","${entry.object.replace(/"/g, '""')}","${entry.size || 0}",""\n`;
                fs.appendFileSync(reportFilePath, csvRow);
                broadcastSSE({ type: 'stats', stats: currentJob.stats });
              }

              // Handle errors
              if (entry.level === 'error') {
                currentJob.stats.lastLog = entry.msg || 'Transfer error occurred';
                const errRow = `"${new Date().toISOString()}","ERROR","FAILED","${(entry.object || '').replace(/"/g, '""')}","0","${(entry.msg || '').replace(/"/g, '""')}"\n`;
                fs.appendFileSync(reportFilePath, errRow);
                broadcastSSE({ type: 'stats', stats: currentJob.stats });
              }

            } catch (e) {
              // Non-JSON standard log line or error
              currentJob.stats.lastLog = line.trim();
              broadcastSSE({ type: 'stats', stats: currentJob.stats });
            }
          });
        });

        proc.on('close', code => {
          currentJob.running = false;
          currentJob.endTime = new Date().toISOString();
          currentJob.stats.transferring = [];
          console.log(`[Migration Finished] Process exited with code ${code}`);

          if (code === 0) {
            currentJob.stats.percentage = 100;
            broadcastSSE({
              type: 'completed',
              success: true,
              reportFile: currentJob.reportFile,
              stats: currentJob.stats
            });
          } else {
            broadcastSSE({
              type: 'completed',
              success: false,
              code,
              error: currentJob.stats.lastLog || `Engine process stopped (code ${code})`,
              reportFile: currentJob.reportFile,
              stats: currentJob.stats
            });
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Migration engine started successfully',
          reportFile: reportFilename
        }));

      } catch (e) {
        currentJob.running = false;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- API: Stop Active Migration ---
  if (pathname === '/api/migrate/stop' && req.method === 'POST') {
    if (currentJob.running && currentJob.process) {
      currentJob.process.kill('SIGINT');
      currentJob.running = false;
      currentJob.endTime = new Date().toISOString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Migration stopped' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No migration is currently running' }));
    }
    return;
  }

  // --- API: Download Audit Report CSV ---
  if (pathname.startsWith('/api/report/download/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(REPORTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Report file not found' }));
    }
    return;
  }

  // --- Serve Static Frontend Files ---
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`🚀 Workspace Migration Studio is live!`);
  console.log(`👉 Access Dashboard: http://localhost:${PORT}`);
  console.log(`========================================================\n`);
});
