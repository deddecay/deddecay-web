// Fan moments 用 OGP 画像（1200x630）を生成する。
// 使い方: node scripts/generate-fan-moments-og.mjs [元ロゴPNG]
// 元ロゴは読み取るだけで、変更・上書きしない。フォントはサイトと同じ Geist（next/og 同梱）。
import { readFile, writeFile } from "node:fs/promises";
import { ImageResponse } from "next/og.js";
import sharp from "sharp";

const SRC = process.argv[2] ?? `${process.env.HOME}/Downloads/deddecay_logo_BL.png`;
const OUT = new URL("../public/og/og-fan-moments.png", import.meta.url);
const FONT = new URL(
  "../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf",
  import.meta.url,
);

const WIDTH = 1200;
const HEIGHT = 630;
const LOGO_WIDTH = 720;

// 縦横比を保ったまま縮小する（形状は変えない）
const logo = await sharp(SRC)
  .resize({ width: LOGO_WIDTH })
  .png()
  .toBuffer({ resolveWithObject: true });
const logoUri = `data:image/png;base64,${logo.data.toString("base64")}`;

const element = {
  type: "div",
  props: {
    style: {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "#ffffff",
    },
    children: [
      {
        type: "img",
        props: {
          src: logoUri,
          width: logo.info.width,
          height: logo.info.height,
        },
      },
      {
        type: "div",
        props: {
          style: {
            marginTop: 48,
            fontSize: 44,
            letterSpacing: "0.3em",
            color: "#000000",
          },
          children: "Fan moments",
        },
      },
    ],
  },
};

const res = new ImageResponse(element, {
  width: WIDTH,
  height: HEIGHT,
  fonts: [{ name: "Geist", data: await readFile(FONT), weight: 400, style: "normal" }],
});
await writeFile(OUT, Buffer.from(await res.arrayBuffer()));
console.log(`wrote public/og/og-fan-moments.png (${WIDTH}x${HEIGHT})`);
