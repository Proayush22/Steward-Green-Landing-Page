# StewardAir - Aerial Wildlife Intelligence

A creative, scroll-driven landing page concept for StewardAir by Steward Green. The experience uses a WebGL United States map, sequential state highlighting, an interactive thermal deer-density field, and flight/coverage storytelling to communicate the scale of the team's deer density work.

## Highlights

- Three.js WebGL map built from published `us-atlas` state geometry
- Scroll-driven highlighting for all 16 states represented in the study history
- Cursor-reactive thermal density field for approximately 54,820 confirmed deer
- Animated project, client, density, flight, and coverage statistics
- Responsive layout with reduced-motion support and semantic page structure
- No Mapbox token or paid mapping service required

## Run locally

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

The production output is written to `dist/`.

## Data notes

The experience uses cumulative figures supplied by Steward Green through 2026:

- Approximately 54,820 deer confirmed
- 88 deer per square mile on average
- 772 square miles / 494,080 acres collected, analyzed, mapped, and reported
- 6,452 UAS flight miles
- 624 flight hours, equivalent to 16 work weeks
- 312 project areas
- 38 clients across 16 states

The supplied source notes that these cumulative figures include Steward Green work and the contributor's professional work completed before Steward Green. The qualifier appears in the site footer.

## Brand and content

The visual direction evolves Steward Green's current blue-and-green identity into a darker StewardAir aerial-data experience. Contact and service links point to the existing Steward Green website.
