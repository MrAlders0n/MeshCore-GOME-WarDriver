export async function onRequest(context) {
  const sampleStore = context.env.SAMPLES;
  const repeaterStore = context.env.REPEATERS;
  const responseData = {
    samples: [],
    repeaters:[]
  };

  const samplesList = await sampleStore.list();
  samplesList.keys.forEach(s => {
    responseData.samples.push({
      time: s.metadata.time,
      lat: s.metadata.lat,
      lon: s.metadata.lon,
      path: s.metadata.path,
    });
  });

  const repeatersList = await repeaterStore.list();
  repeatersList.keys.forEach(s => {
    responseData.repeaters.push({
      id: s.metadata.id,
      name: s.metadata.name,
      lat: s.metadata.lat,
      lon: s.metadata.lon,
      path: s.metadata.path,
    });
  });

  return new Response(JSON.stringify(responseData));
}
