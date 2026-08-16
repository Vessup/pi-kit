import { expect, test } from "bun:test";
import { anchoredPopoverPosition } from "../web/client/anchored-position.ts";

test("send menu opens above a bottom mobile anchor inside the visual viewport", () => {
  expect(
    anchoredPopoverPosition({
      anchor: { left: 340, right: 380, top: 510, bottom: 546 },
      panelWidth: 224,
      panelHeight: 86,
      viewport: { offsetLeft: 0, offsetTop: 120, width: 390, height: 450 },
      align: "end",
    }),
  ).toEqual({ left: 156, top: 418 });
});

test("portaled menus clamp to shifted mobile visual viewports", () => {
  expect(
    anchoredPopoverPosition({
      anchor: { left: 4, right: 44, top: 130, bottom: 166 },
      panelWidth: 224,
      panelHeight: 200,
      viewport: { offsetLeft: 12, offsetTop: 100, width: 320, height: 280 },
      align: "end",
    }),
  ).toEqual({ left: 20, top: 172 });
});
