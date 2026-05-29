const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const uuid = crypto.randomUUID();
const tempDbPath = path.join('/tmp', `webhook_test_${timestamp}_${uuid}.db`);
const databaseUrl = `file:${tempDbPath}`;

console.log(`Using temporary database: ${databaseUrl}`);

process.env.DATABASE_URL = databaseUrl;

function cleanup() {
  if (fs.existsSync(tempDbPath)) {
    console.log(`Cleaning up temporary database: ${tempDbPath}`);
    try {
      fs.unlinkSync(tempDbPath);
      const journalPath = `${tempDbPath}-journal`;
      if (fs.existsSync(journalPath)) {
        fs.unlinkSync(journalPath);
      }
    } catch (err) {
      console.error('Error cleaning up:', err);
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(); });
process.on('SIGTERM', () => { cleanup(); process.exit(); });

try {
  console.log('Initializing database schema...');
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env: process.env });
  
  console.log('Running tests...');
  execSync('npx vitest run', { stdio: 'inherit', env: process.env });
  
  console.log('Tests completed successfully!');
} catch (error) {
  console.error('Error running tests:', error);
  process.exit(1);
}
