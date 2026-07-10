const fs = require('fs');
const path = require('path');

function timestamp() {
  return new Date().toISOString();
}

function appendLog(hub, message) {
  const dir = path.join(hub, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'control-plane.log'), `${timestamp()} control-plane: ${message}\n`);
}

module.exports = { appendLog };
