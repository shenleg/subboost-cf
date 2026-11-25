// next/link 的浏览器适配：沿用真实链接并接入 SPA 导航。
import type { ComponentProps } from "react";
import { Link as RouterLink } from "react-router";

type LinkProps = ComponentProps<"a"> & { href: string };

/** 将链接属性及目标地址传给路由链接；下载仍由浏览器处理，无自定义异常。 */
export default function Link({ href, ...props }: LinkProps) {
  if (props.download !== undefined && props.download !== false) return <a href={href} {...props} />;
  return <RouterLink to={href} {...props} />;
}
