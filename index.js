const bedrock = require('bedrock-protocol');

const client = bedrock.createClient({
  host: process.env.MC_HOST || 'your.server.ip', 
  port: parseInt(process.env.MC_PORT) || 19132, // Bedrock default port is 19132
  username: process.env.MC_USERNAME || 'BedrockAFKBot',
  offline: true // Set to false if you are joining a server requiring formal Xbox Live login
});

client.on('join', () => {
  console.log('✅ Bedrock Bot successfully joined the server!');
  
  // Anti-AFK chat trigger to keep entity session active
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
