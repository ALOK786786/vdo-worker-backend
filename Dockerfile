FROM node:18-slim

# Install system dependencies (ffmpeg, python3, pip, curl, unzip)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno (The primary default JS runtime recommended by yt-dlp)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install yt-dlp using pip with [default] extra to bundle EJS challenge solver scripts natively
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy application source
COPY . .

# Expose server port
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
