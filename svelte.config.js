import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ out: 'build' }),
    csrf: {
      trustedOrigins: [
        'http://127.0.0.1:4311',
        'http://localhost:4311',
        'http://127.0.0.1:3000',
        'http://localhost:3000'
      ]
    }
  }
};

export default config;
