const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const port = 5000;

app.use(express.json());
app.use(cors());

// Serve the public directory (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Serve the downloads directory to make files accessible
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// WebSocket setup
const wsServer = new WebSocket.Server({ noServer: true });
let wsClients = [];
let cancelCommand = null;

wsServer.on('connection', (socket) => {
    wsClients.push(socket);

    socket.on('message', (message) => {
        const parsedMessage = JSON.parse(message);
        if (parsedMessage.type === 'cancel') {
            if (cancelCommand) {
                cancelCommand.kill('SIGINT');
                cancelCommand = null;

                wsClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'canceled' }));
                    }
                });

                deleteAllFilesInDownloads();
            }
        }
    });

    socket.on('close', () => {
        wsClients = wsClients.filter(client => client !== socket);
    });
});

app.post('/download', (req, res) => {
    const { url, format } = req.body;
    if (!url || !format) {
        return res.status(400).json({ success: false, message: 'URL and format are required' });
    }

    deleteAllFilesInDownloads();

    const tempOutputPath = path.join(__dirname, 'downloads', 'temp_media');
    let ytDlpArgs = ['-f', 'bestvideo+bestaudio', '-o', tempOutputPath, url];
    if (format === 'mp4') {
        ytDlpArgs.push('--merge-output-format', 'mp4');
    } else if (format === 'mp3') {
        ytDlpArgs = ['-x', '--audio-format', 'mp3', '-o', tempOutputPath, url];
    } else {
        return res.status(400).json({ success: false, message: 'Unsupported format' });
    }

    const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp');
    const downloadProcess = spawn(ytDlpPath, ytDlpArgs);
    cancelCommand = downloadProcess;

    downloadProcess.stdout.on('data', (data) => {
        const progress = extractProgress(data);
        if (progress !== null) {
            console.log(`Progress: ${progress}%`);
            wsClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'progress', progress }));
                }
            });
        }
    });

    downloadProcess.stderr.on('data', (data) => {
        console.error(`Error: ${data}`);
    });

    downloadProcess.on('close', (code) => {
        cancelCommand = null;
        if (code === 0) {
            console.log('Download completed successfully.');
            getMediaTitle(url, (title) => {
                const extension = format === 'mp4' ? 'mp4' : 'mp3';
                const tempFilePath = `${tempOutputPath}.${extension}`;
                const outputPath = path.join(__dirname, 'downloads', `${sanitizeFilename(title)}.${extension}`);

                console.log(`Renaming from ${tempFilePath} to ${outputPath}`); // Log file paths

                fs.rename(tempFilePath, outputPath, (err) => {
                    if (err) {
                        console.error('Error renaming file:', err);
                        return res.status(500).json({ success: false, message: 'Error saving file.' });
                    }

                    console.log(`File saved at: ${outputPath}`);  // Log the saved file path for debugging

                    // Sending back the correct download URL to the frontend
                    res.json({
                        success: true,
                        message: 'Download completed.',
                        downloadUrl: `/downloads/${sanitizeFilename(title)}.${extension}`,
                        previewUrl: `/downloads/${sanitizeFilename(title)}.${extension}` // URL for preview
                    });
                });
            });
        } else {
            console.error('Download failed with code', code);
            res.status(500).json({ success: false, message: 'Download failed.' });
        }
    });
});

function extractProgress(data) {
    const output = data.toString();
    const progressMatch = output.match(/\[download\]\s+(\d{1,3}\.\d+)%/);
    if (progressMatch) {
        return progressMatch[1];
    }
    return null;
}

function deleteAllFilesInDownloads() {
    const downloadsDir = path.join(__dirname, 'downloads');
    fs.readdir(downloadsDir, (err, files) => {
        if (err) {
            console.error('Error reading downloads directory:', err);
            return;
        }
        files.forEach(file => {
            const filePath = path.join(downloadsDir, file);
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error('Error deleting file:', err);
                } else {
                    console.log('Deleted file:', filePath);
                }
            });
        });
    });
}

function getMediaTitle(url, callback) {
    const ytDlpPath = path.join(__dirname, 'bin', 'yt-dlp');
    const ytDlpArgs = ['--get-title', url];
    const process = spawn(ytDlpPath, ytDlpArgs);
    let title = '';

    process.stdout.on('data', (data) => {
        title += data.toString();
    });

    process.on('close', () => {
        callback(title.trim());
    });
}

function sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

server.on('upgrade', (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
        wsServer.emit('connection', ws, request);
    });
});
