# Workspace Migration Studio

A fast, clean, cloud-to-cloud file migration studio for Google Workspace experts.

Built to migrate files seamlessly between:
- **Google Drive to Google Drive** (Personal Gmail to Google Workspace, Workspace Tenant to Tenant, Shared Drives)
- **OneDrive / SharePoint to Google Drive**
- **Dropbox / Box to Google Drive**

---

## ⚡ Key Highlights

1. **Dead-Simple Web UI**:
   - Point-and-click browser interface at `http://localhost:3050`.
   - 1-click browser OAuth login for Google Drive and Microsoft OneDrive.
   - Zero terminal commands needed.

2. **⚡ Turbo Mode for Massive File Counts**:
   - Automatically solves the bottleneck of migrations slowing down when clients have 10,000 to 1,000,000+ files.
   - **`--fast-list`**: Traverses directory trees in bulk in-memory (100x faster than folder-by-folder API calls).
   - **16 Parallel Checkers & 8 Parallel Streams**: Keeps bandwidth saturated.
   - **Rate-Limit Auto-Pacing (`--tpslimit=10`)**: Prevents Google and Microsoft 403 / 429 throttling blocks.
   - **Instant Server-Side Copy**: When moving Google Drive to Google Drive, files move across Google's internal datacenter without downloading to your computer.

3. **Pre-Flight Audit & Client Reports**:
   - **Dry Run Simulation**: Accurately counts total gigabytes, file numbers, and tests permissions before transferring.
   - **1-Click Audit Report (CSV)**: Exportable report listing every transferred file, size, timestamp, and MD5 checksum verification.

---

## 🚀 How to Launch Anytime

### Method 1: Double-Click
Double-click **`Launch Migration Studio.command`** in Finder.

### Method 2: Command Line
```bash
cd /Users/altafnadaf/Documents/antigravity/goofy-borg/workspace-migrator
./start.sh
```

### Method 3: Run with Free Cloudflare Tunnel
```bash
./start.sh --cloudflare
```
Cloudflare will give you an instant, secure `https://...` link to access your dashboard from anywhere.
