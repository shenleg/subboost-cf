/// <reference lib="dom" />

// 补齐共享订阅核心使用的 Web 类型和仓库内生成的 Peggy 模块声明，不引入浏览器运行时。
type GeneratedProxyLineParser = () => { parse(input: string): unknown };

declare module "*peggy/surge" {
  const getParser: GeneratedProxyLineParser;
  export default getParser;
}

declare module "*peggy/loon" {
  const getParser: GeneratedProxyLineParser;
  export default getParser;
}

declare module "*peggy/qx" {
  const getParser: GeneratedProxyLineParser;
  export default getParser;
}
