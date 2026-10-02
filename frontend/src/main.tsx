import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Image, Window } from "@zturnlibs/ztron-api";
import App from "./App";
import iconUrl from "./assets/app-icon.png";
import "./index.css";

// 用打包进前端的 PNG 设置原生窗口图标（任务栏 / 标题栏）。
fetch(iconUrl)
  .then((r) => r.arrayBuffer())
  .then((buf) => Image.fromBytes(new Uint8Array(buf)))
  .then((img) => Window.getCurrent().setIcon(img))
  .catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
