-- Reference data. Idempotent: safe to run on every start.
-- Prices are illustrative, not a published Botswana tariff.

INSERT INTO vehicle_classes (code, name, description) VALUES
  ('M', 'Motorcycle',   'Motorcycles and tricycles'),
  ('1', 'Light',        'Cars, SUVs and light delivery vehicles with 2 axles'),
  ('2', 'Medium',       'Minibuses, buses and 2-axle heavy vehicles'),
  ('3', 'Heavy',        'Vehicles with 3 or 4 axles'),
  ('4', 'Extra heavy',  'Vehicles with 5 or more axles, including most haulage rigs')
ON CONFLICT (code) DO NOTHING;

-- Three virtual gantries on the A1 between Gaborone and Mahalapye.
-- km is measured north from the Gaborone end. Coordinates are approximate and
-- will be replaced by snapped positions from the SUMO network.
INSERT INTO gantries (id, name, road, km, direction, lat, lng) VALUES
  ('A1-G01', 'Mmamashia', 'A1', 18.0,  'both', -24.4560, 26.0060),
  ('A1-G02', 'Artesia',   'A1', 78.0,  'both', -24.0300, 26.3000),
  ('A1-G03', 'Dibete',    'A1', 128.0, 'both', -23.7500, 26.4300)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tariffs (gantry_id, vehicle_class, amount_thebe, valid_from)
SELECT g.id, c.code, c.amount, '2026-01-01T00:00:00Z'
FROM gantries g
CROSS JOIN (VALUES ('M', 800), ('1', 1500), ('2', 3500), ('3', 6000), ('4', 9000)) AS c(code, amount)
WHERE NOT EXISTS (SELECT 1 FROM tariffs);
