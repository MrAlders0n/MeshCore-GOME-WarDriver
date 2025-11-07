export async function onRequest(context) {
  const request = context.request;
  const data = await request.json();
  const store = context.env.REPEATERS;

  const id = data.id;
  const name = data.name;
  const lat = parseFloat(data.lat);
  const lon = parseFloat(data.lon);
  const path = data.path ?? [];

  if (isNaN(lat) || isNaN(lon) || id.length !== 2) {
    throw new Error(`Invalid data ${JSON.stringify(data)}`);
  }

  const key = `${id}|${lat}|${lon}`;
  await store.put(key, "", {
    metadata: { id: id, name: name, lat: lat, lon: lon, path: path }
  });

  return new Response('OK');
}
