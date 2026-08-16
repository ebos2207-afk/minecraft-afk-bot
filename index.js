const bedrock = require('bedrock-protocol');
const http = require('http');

// 🟢 THIS PART KEEPS IT ON THE FREE TIER BY TALKING TO RENDER
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running 24/7!\n');
}).listen(process.env.PORT || 10000);

// 🎮 MINECRAFT BOT CONNECTION
const client = bedrock.createClient({
  host: process.env.MC_HOST || 'your.server.ip', 
  port: parseInt(process.env.MC_PORT) || 19132, 
  username: process.env.MC_USERNAME || 'BedrockAFKBot',
  offline: true 
});

client.on('join', () => {
  console.log('✅ Bedrock Bot successfully joined the server!');
  
  setInterval(() => {
    client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: client.username,
      xuid: '',
      platform_chat_id: '',
      message: 'KeepAlive Loop'
    });
  }, 60000);
});

client.on('error', (err) => console.log(`⚠️ Bedrock Client Error: ${err}`));
client.on('close', () => console.log('❌ Connection closed.'));
