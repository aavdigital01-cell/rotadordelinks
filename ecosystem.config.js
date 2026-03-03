module.exports = {
  apps: [{
    name: 'linkrotator',
    script: './server/index.js',
    cwd: '/root/rotadordelinks',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      TZ: 'America/Sao_Paulo'
    }
  }]
};
