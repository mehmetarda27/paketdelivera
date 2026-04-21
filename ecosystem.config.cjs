module.exports = {
  apps: [
    {
      name: "delivera-express",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        TRUST_PROXY: "true",
        FORCE_HTTPS: "true"
      }
    }
  ]
};
