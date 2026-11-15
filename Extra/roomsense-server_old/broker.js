// RoomSense step 1: minimal MQTT broker to prove the Pi can reach the laptop.
const aedes = require('aedes')();
const server = require('net').createServer(aedes.handle);
const PORT = 1883;

server.listen(PORT, '0.0.0.0', () => console.log(`MQTT broker listening on port ${PORT}. Waiting for the Pi...`));

aedes.on('client', (client) => console.log(`connected:    ${client.id}`));
aedes.on('clientDisconnect', (client) => console.log(`disconnected: ${client.id}`));
aedes.on('publish', (packet, client) => {
  if (client) console.log(`${client.id} -> ${packet.topic}: ${packet.payload.toString()}`);
});