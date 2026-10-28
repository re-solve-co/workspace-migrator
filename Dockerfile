FROM node:20-alpine

# Install rclone, curl, and CA certificates
RUN apk add --no-cache rclone curl ca-certificates

WORKDIR /app

# Copy application files (Zero external npm dependencies needed!)
COPY server.js .
COPY public ./public
RUN mkdir -p reports /root/.config/rclone

ENV PORT=3050
EXPOSE 3050

CMD ["node", "server.js"]
