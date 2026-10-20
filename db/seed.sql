-- Reference data. Idempotent: safe to run on every start.
-- Prices are illustrative, not a published Botswana tariff.

INSERT INTO vehicle_classes (code, name, description) VALUES
  ('M', 'Motorcycle',   'Motorcycles and tricycles'),
  ('1', 'Light',        'Cars, SUVs and light delivery vehicles with 2 axles'),
  ('2', 'Medium',       'Minibuses, buses and 2-axle heavy vehicles'),
  ('3', 'Heavy',        'Vehicles with 3 or 4 axles'),
  ('4', 'Extra heavy',  'Vehicles with 5 or more axles, including most haulage rigs')
ON CONFLICT (code) DO NOTHING;

-- Three mainline toll plazas on the A1 between Gaborone and Mahalapye, five
-- lanes per direction. km and coordinates come from sim/build_network.py: km is
-- along the northbound carriageway of the SUMO network (which starts at the
-- A1's northern exit from Gaborone) to the booth line. Placement near each
-- place name is approximate. (The table keeps its old name: before the plazas
-- these were open-road gantries.)
INSERT INTO gantries (id, name, road, km, direction, lat, lng, kind, lanes) VALUES
  ('A1-G01', 'Mmamashia', 'A1', 11.8,  'both', -24.520968, 26.001583, 'plaza', 5),
  ('A1-G02', 'Artesia',   'A1', 74.5,  'both', -24.042102, 26.307264, 'plaza', 5),
  ('A1-G03', 'Dibete',    'A1', 108.3, 'both', -23.773491, 26.458261, 'plaza', 5)
ON CONFLICT (id) DO NOTHING;

-- Motorcycles pay the Class 1 toll, as at South African plazas.
INSERT INTO tariffs (gantry_id, vehicle_class, amount_thebe, valid_from)
SELECT g.id, c.code, c.amount, '2026-01-01T00:00:00Z'
FROM gantries g
CROSS JOIN (VALUES ('M', 1500), ('1', 1500), ('2', 3500), ('3', 6000), ('4', 9000)) AS c(code, amount)
WHERE NOT EXISTS (SELECT 1 FROM tariffs);
