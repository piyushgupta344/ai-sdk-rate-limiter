import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ai-sdk-rate-limiter',
  description: 'Smart rate limiting, queuing, and cost tracking middleware for AI SDK calls.',
  base: '/ai-sdk-rate-limiter/',

  head: [
    ['link', { rel: 'icon', href: '/ai-sdk-rate-limiter/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API Reference', link: '/api/reference' },
      { text: 'Changelog', link: '/changelog' },
      {
        text: '0.12.0',
        items: [
          { text: 'npm', link: 'https://www.npmjs.com/package/ai-sdk-rate-limiter' },
          { text: 'GitHub', link: 'https://github.com/piyushgupta344/ai-sdk-rate-limiter' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Cost tracking', link: '/guide/cost-tracking' },
          { text: 'Multi-tenant scopes', link: '/guide/scopes' },
          { text: 'Circuit breaker', link: '/guide/circuit-breaker' },
          { text: 'Metrics & observability', link: '/guide/observability' },
          { text: 'Testing', link: '/guide/testing' },
          { text: 'Advanced patterns', link: '/guide/advanced' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'createRateLimiter()', link: '/api/reference' },
          { text: 'RateLimiterConfig', link: '/api/config' },
          { text: 'Events', link: '/api/events' },
          { text: 'Errors', link: '/api/errors' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/piyushgupta344/ai-sdk-rate-limiter' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/ai-sdk-rate-limiter' },
    ],

    editLink: {
      pattern: 'https://github.com/piyushgupta344/ai-sdk-rate-limiter/edit/main/docs/:path',
      text: 'Edit this page',
    },

    footer: {
      message: 'Released under the MIT License.',
    },

    search: {
      provider: 'local',
    },
  },
})
