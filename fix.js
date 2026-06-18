const fs = require('fs');
const files = ['admin.html', 'restaurant.html', 'courier.html', 'index.html'];
const ts = Date.now();
files.forEach(f => {
  let c = fs.readFileSync(f, 'utf8');
  const name = f === 'index.html' ? 'landing.js' : f.replace('.html', '.js');
  c = c.replace(/<script src="\/=[0-9]+"><\/script>/g, '');
  c = c.replace(/<\/body>/, `<script src="/shared.js?v=${ts}"></script>\n  <script src="/${name}?v=${ts}"></script>\n</body>`);
  fs.writeFileSync(f, c);
  console.log('Fixed ' + f);
});
