require('dotenv').config({ quiet: true });
const path = require('node:path');
const express = require('express');
const axios = require('axios');

const fields = [
  { name: 'name', label: 'Name', maxLength: 100 },
  { name: 'species', label: 'Species', maxLength: 150 },
  { name: 'care_notes', label: 'Care Notes', maxLength: 1000 }
];

function createApp({ token, objectType, client } = {}) {
  if (!objectType || (!client && !token)) {
    throw new Error('Set HUBSPOT_ACCESS_TOKEN and HUBSPOT_OBJECT_TYPE in your local .env file.');
  }
  const hubspot = client || axios.create({
    baseURL: 'https://api.hubapi.com', timeout: 15000,
    headers: { Authorization: `Bearer ${token}` }
  });
  const objectsPath = `/crm/v3/objects/${encodeURIComponent(objectType)}`;
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'pug');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Retrieve every page and explicitly request all three custom properties.
  app.get('/', async (req, res) => {
    try {
      const data = [];
      let after;
      const seenCursors = new Set();
      do {
        const response = await hubspot.get(objectsPath, {
          params: { properties: fields.map(field => field.name).join(','), limit: 100, ...(after ? { after } : {}) }
        });
        data.push(...response.data.results);
        after = response.data.paging?.next?.after;
        if (after) {
          if (seenCursors.has(String(after))) throw new Error('Repeated pagination cursor');
          seenCursors.add(String(after));
        }
      } while (after);
      res.render('homepage', { title: 'Plant Catalog | Integrating With HubSpot I Practicum', data, fields });
    } catch (error) {
      // Axios request objects contain credentials, so log only status or error code.
      console.error('HubSpot record retrieval failed', error.response?.status || error.code || 'UNKNOWN');
      res.status(502).render('homepage', {
        title: 'Plant Catalog | Integrating With HubSpot I Practicum', data: [], fields,
        error: 'The plant catalog could not be loaded from HubSpot. Check the connection and try again.'
      });
    }
  });

  app.get('/update-cobj', (req, res) => {
    res.render('updates', {
      title: 'Update Custom Object Form | Integrating With HubSpot I Practicum', fields, values: {}, errors: []
    });
  });

  app.post('/update-cobj', async (req, res) => {
    // Reject submissions originating on another website to this local-only app.
    if (req.get('origin') && req.get('origin') !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).send('This form must be submitted from the local app.');
    }
    const properties = {};
    const errors = [];
    for (const field of fields) {
      const raw = req.body?.[field.name];
      const value = typeof raw === 'string' ? raw.trim() : '';
      properties[field.name] = value;
      if (!value) errors.push(`${field.label} is required.`);
      else if (value.length > field.maxLength) errors.push(`${field.label} must be ${field.maxLength} characters or fewer.`);
    }
    const form = {
      title: 'Update Custom Object Form | Integrating With HubSpot I Practicum', fields, values: properties, errors
    };
    if (errors.length) return res.status(400).render('updates', form);
    try {
      await hubspot.post(objectsPath, { properties });
      res.redirect(303, '/');
    } catch (error) {
      console.error('HubSpot record creation failed', error.response?.status || error.code || 'UNKNOWN');
      form.errors = ['HubSpot could not confirm the new record. Check the catalog before retrying to avoid a duplicate.'];
      res.status(502).render('updates', form);
    }
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp({ token: process.env.HUBSPOT_ACCESS_TOKEN, objectType: process.env.HUBSPOT_OBJECT_TYPE });
  app.listen(port, '127.0.0.1', () => console.log(`Plant catalog listening on http://localhost:${port}`));
}

module.exports = { createApp, fields };
