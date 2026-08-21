import { expect, test } from "bun:test";
import {
  anchoredPopoverBelowPosition,
  anchoredPopoverPosition,
} from "../web/client/anchored-position.ts";

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

test("below placement flips above the anchor when the keyboard leaves little room", () => {
  expect(
    anchoredPopoverBelowPosition({
      anchor: { left: 20, right: 380, top: 300, bottom: 336 },
      panelWidth: 360,
      panelMaxHeight: 256,
      viewport: { offsetLeft: 0, offsetTop: 120, width: 390, height: 250 },
      align: "start",
    }),
  ).toEqual({
    left: 20,
    top: 128,
    maxHeight: 166,
    placement: "above",
    visible: true,
  });
});

test("below placement hides a menu when neither side has room", () => {
  expect(
    anchoredPopoverBelowPosition({
      anchor: { left: 20, right: 380, top: 10, bottom: 46 },
      panelWidth: 360,
      viewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 0 },
      align: "start",
    }),
  ).toMatchObject({ maxHeight: 0, visible: false });
});

test("below placement hides a menu capped to zero height", () => {
  expect(
    anchoredPopoverBelowPosition({
      anchor: { left: 20, right: 380, top: 100, bottom: 136 },
      panelWidth: 360,
      panelMaxHeight: 0,
      viewport: { offsetLeft: 0, offsetTop: 0, width: 390, height: 600 },
      align: "start",
    }),
  ).toMatchObject({ maxHeight: 0, visible: false });
});
