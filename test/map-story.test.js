import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getMapStoryProgress, MAP_STORY_SEQUENCE_RANGE_RATIO } from "../src/map-story-progress.js";

const [html, css, script] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/style.css", import.meta.url), "utf8"),
  readFile(new URL("../src/main.js", import.meta.url), "utf8"),
]);

test("map story copy stays sticky for the whole illumination section", () => {
  const panelRule = css.match(/\.map-story__sticky\s*\{([^}]*)\}/)?.[1] ?? "";
  const sectionRule = css.match(/\.map-story\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(panelRule, /position:\s*sticky/);
  assert.match(panelRule, /top:\s*max\(7rem,\s*10vh\)/);
  assert.match(sectionRule, /min-height:\s*230svh/);
  assert.doesNotMatch(css, /\.map-story__sticky\.is-(?:pinned|released)/);
  assert.doesNotMatch(script, /mapStoryPanel|is-pinned|is-released/);
});

test("map story still contains the full set of 16 states", () => {
  const story = html.match(/<section class="map-story"[\s\S]*?<\/section>/)?.[0] ?? "";
  const states = [...story.matchAll(/<li\s+data-fips=/g)];

  assert.equal(states.length, 16);
  assert.match(story, /id="map-progress-count"/);
});

test("all states illuminate before the sticky section reaches its end", () => {
  const mapRange = 1_300;
  const zoomRange = 80;
  const completionTravel = zoomRange + mapRange * MAP_STORY_SEQUENCE_RANGE_RATIO;
  const stateSixteenStartsAt = zoomRange + mapRange * MAP_STORY_SEQUENCE_RANGE_RATIO * (15 / 16);

  assert.equal(getMapStoryProgress(zoomRange, mapRange, zoomRange), 0);
  assert.equal(getMapStoryProgress(stateSixteenStartsAt, mapRange, zoomRange), 15 / 16);
  assert.equal(getMapStoryProgress(completionTravel, mapRange, zoomRange), 1);
  assert.ok(completionTravel < mapRange, "sequence should finish before the section boundary");
  assert.ok(mapRange - completionTravel > mapRange * 0.2, "keep a visible sticky runway after Oklahoma");
});
