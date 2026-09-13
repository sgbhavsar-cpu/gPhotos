const { spawn } = require('child_process');
const path = require('path');

console.log('=== Electron Smoke Test: Testing Renderer Mount & App Ready ===');

const electronExecutable = require('electron');
const appProcess = spawn(electronExecutable, ['.', '--smoke-test'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, NODE_ENV: 'production', GPHOTOS_SMOKE_TEST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let appReadyReceived = false;
let output = '';

appProcess.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  process.stdout.write(text);

  if (text.includes("'app:ready' signal received from renderer")) {
    appReadyReceived = true;
    console.log('\n\n🎉 SUCCESS: Renderer mounted perfectly and sent app:ready signal!');
    setTimeout(() => {
      appProcess.kill();
      process.exit(0);
    }, 1500);
  }
});

appProcess.stderr.on('data', (data) => {
  const text = data.toString();
  output += text;
  process.stderr.write(text);
});

// Timeout after 15 seconds
setTimeout(() => {
  if (!appReadyReceived) {
    console.error('\n❌ Smoke Test Timed Out: app:ready was not received within 15 seconds.');
    appProcess.kill();
    process.exit(1);
  }
}, 15000);
