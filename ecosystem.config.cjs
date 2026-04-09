module.exports = {
  apps: [{
    name: 'pool-heat-manager',
    script: 'npx',
    args: 'tsx src/index.ts',
    cwd: '/root/pool-heat-manager',
    env: {
      NODE_ENV: 'production',
      // All properties are in America/New_York. The app also uses
      // property.timezone for wall-clock calculations via zonedDate(),
      // but setting TZ here is a safety net so naive Date parsing and
      // log timestamps also land in ET instead of UTC.
      TZ: 'America/New_York',
    },
    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // Log management
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/root/pool-heat-manager/logs/error.log',
    out_file: '/root/pool-heat-manager/logs/out.log',
    merge_logs: true,
    // Memory limit — restart if exceeds 200MB (server has 1GB)
    max_memory_restart: '200M',
  }],
};
