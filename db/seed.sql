-- Reference data. Idempotent: safe to run on every start.
-- Prices are illustrative, not a published Botswana tariff.

INSERT INTO vehicle_classes (code, name, description) VALUES
  ('M', 'Motorcycle',   'Motorcycles and tricycles'),
  ('1', 'Light',        'Cars, SUVs and light delivery vehicles with 2 axles'),
  ('2', 'Medium',       'Minibuses, buses and 2-axle heavy vehicles'),
  ('3', 'Heavy',        'Vehicles with 3 or 4 axles'),
  ('4', 'Extra heavy',  'Vehicles with 5 or more axles, including most haulage rigs')
ON CONFLICT (code) DO NOTHING;

-- Three virtual gantries on the A1 between Gaborone and Mahalapye. km and
-- coordinates come from sim/build_network.py: km is along the northbound
-- carriageway of the SUMO network, which starts at the A1's northern exit from
-- Gaborone. Placement near each place name is approximate.
INSERT INTO gantries (id, name, road, km, direction, lat, lng) VALUES
  ('A1-G01', 'Mmamashia', 'A1', 11.8,  'both', -24.520967, 26.001583),
  ('A1-G02', 'Artesia',   'A1', 75.4,  'both', -24.035115, 26.311252),
  ('A1-G03', 'Dibete',    'A1', 108.3, 'both', -23.773484, 26.458248)
ON CONFLICT (id) DO NOTHING;

INSERT INTO tariffs (gantry_id, vehicle_class, amount_thebe, valid_from)
SELECT g.id, c.code, c.amount, '2026-01-01T00:00:00Z'
FROM gantries g
CROSS JOIN (VALUES ('M', 800), ('1', 1500), ('2', 3500), ('3', 6000), ('4', 9000)) AS c(code, amount)
WHERE NOT EXISTS (SELECT 1 FROM tariffs);
