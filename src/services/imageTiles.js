import sharp from "sharp";
import { getRenderedJpeg } from "./orthanc.js";

const TILE_PX = 768;
const GAP_PX = 4;
const GAP_COLOR = "#5a5a5a";

const numberLabel = (n) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="28"><rect width="40" height="28" fill="#000" fill-opacity="0.75"/><text x="20" y="21" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="bold" fill="#fff">${n}</text></svg>`
  );

export function pickImages(study, budget) {
  const series = study.series
    .filter((s) => s.instances.length)
    .map((s) => ({
      uid: s.seriesInstanceUid,
      seriesNumber: s.seriesNumber,
      images: [...s.instances]
        .sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0))
        .flatMap(({ orthancId, sopInstanceUid, instanceNumber, frames }) => {
          const image = { orthancId, sopInstanceUid, instanceNumber };
          return frames > 1 ? Array.from({ length: frames }, (_, f) => ({ ...image, frame: f + 1 })) : [image];
        }),
    }))
    .slice(0, budget);
  const shares = series.map(() => 1);
  for (let left = budget - series.length; left > 0; left--) {
    let best = -1;
    for (const [i, s] of series.entries()) {
      if (shares[i] < s.images.length && (best === -1 || s.images.length / shares[i] > series[best].images.length / shares[best])) best = i;
    }
    if (best === -1) break;
    shares[best]++;
  }
  return series.flatMap((s, i) =>
    Array.from({ length: shares[i] }, (_, k) => {
      const { orthancId, sopInstanceUid, instanceNumber, frame } = s.images[Math.floor(((k + 0.5) * s.images.length) / shares[i])];
      return { orthancId, sopInstanceUid, instanceNumber, frame, seriesInstanceUid: s.uid, seriesNumber: s.seriesNumber };
    })
  );
}

export const cellSize = (grid) => Math.floor((TILE_PX - GAP_PX * (grid - 1)) / grid);

export async function buildTiles(images, grid, render = getRenderedJpeg) {
  const perTile = grid * grid;
  const cell = cellSize(grid);
  const tiles = [];
  for (let start = 0; start < images.length; start += perTile) {
    const group = images.slice(start, start + perTile);
    const cols = Math.min(group.length, grid);
    const rows = Math.ceil(group.length / grid);
    const cells = await Promise.all(
      group.map(async (image, i) => {
        const rendered = sharp(Buffer.from(await render(image.orthancId, cell, image.frame)));
        const { width, height } = await rendered.metadata();
        const scale = Math.min(cell / width, cell / height);
        const shown = { width: Math.round(width * scale), height: Math.round(height * scale) };
        image.view = { cell, ...shown, left: Math.floor((cell - shown.width) / 2), top: Math.floor((cell - shown.height) / 2) };
        return {
          input: await rendered
            .resize(cell, cell, { fit: "contain", background: "#000" })
            .composite([{ input: numberLabel(start + i + 1), top: 0, left: 0 }])
            .toBuffer(),
          left: (i % grid) * (cell + GAP_PX),
          top: Math.floor(i / grid) * (cell + GAP_PX),
        };
      })
    );
    const jpeg = await sharp({
      create: { width: cols * cell + (cols - 1) * GAP_PX, height: rows * cell + (rows - 1) * GAP_PX, channels: 3, background: GAP_COLOR },
    })
      .composite(cells)
      .jpeg({ quality: 85 })
      .toBuffer();
    tiles.push({ jpeg, first: start + 1, last: start + group.length });
  }
  return tiles;
}
