// 开发用 Mock Source：不伪造生产数据，仅用于在无外网/无真实来源时验证
// fetch → parse → normalize → storage → threshold → alert → command output 全链路。
// 只有配置显式开启 enableMockSource 时才会注册（见 sources.js buildSourceAdapters），
// 产出 listing 一律标记 source: 'mock'，runs/listings 中可识别、可清理。
const MOCK_LISTINGS = [
  {
    source: 'mock',
    sourceId: 'mock-below-threshold',
    title: 'Lenovo ThinkStation P3 Tiny i5-13500T 16GB 512GB',
    description: '开发用固定样本：低于默认阈值 1500 元，应产生一条报警。',
    url: 'https://mock.local/listing/below-threshold',
    price: 1200,
    shipping: 0,
    currency: 'CNY',
    condition: 'used',
    cpu: 'i5-13500T',
  },
  {
    source: 'mock',
    sourceId: 'mock-above-threshold-near',
    title: 'Lenovo ThinkStation P3 Tiny i5-13500T 32GB 1TB',
    description: '开发用固定样本：高于默认阈值 1500 元，不应产生报警。',
    url: 'https://mock.local/listing/above-threshold-near',
    price: 1800,
    shipping: 0,
    currency: 'CNY',
    condition: 'used',
    cpu: 'i5-13500T',
  },
  {
    source: 'mock',
    sourceId: 'mock-above-threshold-far',
    title: 'Lenovo ThinkStation P3 Tiny i7-14700T 32GB 1TB',
    description: '开发用固定样本：明显高于默认阈值 1500 元，不应产生报警。',
    url: 'https://mock.local/listing/above-threshold-far',
    price: 2200,
    shipping: 0,
    currency: 'CNY',
    condition: 'used',
    cpu: 'i7-14700T',
  },
]

export function createMockSourceAdapter() {
  return {
    id: 'mock',
    developmentOnly: true,
    canHandle: url => url.protocol === 'mock:',
    async fetchListings() {
      const capturedAt = new Date().toISOString()
      return { listings: MOCK_LISTINGS.map(listing => ({ ...listing, capturedAt })) }
    },
  }
}
