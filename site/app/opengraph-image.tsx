import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const alt = "What did I miss?";
export const size = {
  width: 2400,
  height: 1260
};
export const contentType = "image/png";

export default async function Image() {
  const [brandFont, icon] = await Promise.all([
    readFile(path.join(process.cwd(), "public/fonts/instrument-serif-regular.ttf")),
    readFile(path.join(process.cwd(), "public/wdim-icon.png"))
  ]);
  const iconSrc = `data:image/png;base64,${icon.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: "#fffdf8",
          color: "#071109"
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 14% 82%, rgba(200, 229, 206, 0.72), transparent 25%), radial-gradient(circle at 86% 78%, rgba(244, 236, 196, 0.82), transparent 27%), radial-gradient(ellipse at 50% 76%, rgba(99, 217, 127, 0.2), transparent 30%)"
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 60,
            border: "1px solid rgba(7, 17, 9, 0.12)",
            borderRadius: 68
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 108,
            left: 116,
            display: "flex",
            alignItems: "center",
            gap: 28,
            fontFamily: "Instrument Serif",
            fontSize: 76
          }}
        >
          <img
            src={iconSrc}
            alt=""
            style={{
              width: 68,
              height: 68,
              borderRadius: 18,
              objectFit: "cover"
            }}
          />
          <span>wdim</span>
        </div>
        <div
          style={{
            display: "flex",
            maxWidth: 1880,
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontFamily: "Instrument Serif",
            fontSize: 268,
            fontWeight: 400,
            letterSpacing: 0,
            lineHeight: 0.88
          }}
        >
          What did I miss?
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Instrument Serif",
          data: brandFont,
          style: "normal",
          weight: 400
        }
      ]
    }
  );
}
