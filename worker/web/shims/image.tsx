// next/image 的浏览器适配：共享 UI 使用的图片由静态资源直接提供。
import type { ComponentProps } from "react";

/** 按 UI 提供的原生图片属性渲染图片，不请求 Next 优化端点，无自定义异常。 */
export default function Image(props: ComponentProps<"img">) {
  return <img {...props} />;
}
