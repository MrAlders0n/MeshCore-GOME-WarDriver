// Pull all the live KV data into the local emulator.
export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname !== "localhost")
    return new Response("Only works in Wrangler.");

  const resp = await fetch("https://mesh-map.pages.dev/get-nodes");
  const data = await resp.json();

  const sampleStore = context.env.SAMPLES;
  const repeaterStore = context.env.REPEATERS;

  let work = data.samples.map(async s => {
    const key = s.hash;
    const metadata = { time: s.time, path: s.path };
    await sampleStore.put(key, "", {
      metadata: metadata
    });
  });
  await Promise.all(work);

  work = data.repeaters.map(async r => {
    const key = `${r.id}|${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`;
    const metadata = { time: r.time, id: r.id, name: r.name, lat: r.lat, lon: r.lon, elev: r.elev };
    await repeaterStore.put(key, "", {
      metadata: metadata
    });
  });
  await Promise.all(work);

  return new Response("OK");
}
