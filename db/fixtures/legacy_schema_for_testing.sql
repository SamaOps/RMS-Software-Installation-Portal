-- Mirror of the EXISTING navgurukul/windows-rms-server schema (db/schema.js, Drizzle),
-- trimmed to the tables the portal touches. For LOCAL TESTING ONLY. Do NOT run
-- against production. Note the real names: donors.donor_name, "NGOs"."NGO_name",
-- softwares.isactive / softwares_installed.issuccessful (no underscores).
CREATE TABLE IF NOT EXISTS donors (
  id SERIAL PRIMARY KEY, donor_name VARCHAR(500) NOT NULL, is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "NGOs" (
  id SERIAL PRIMARY KEY, "NGO_name" VARCHAR(500) NOT NULL, unique_key VARCHAR(30) UNIQUE,
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY, username VARCHAR(255) NOT NULL, serial_number VARCHAR(50) NOT NULL UNIQUE,
  mac_address VARCHAR(50) NOT NULL, ngo_id INT REFERENCES "NGOs"(id), donor_id INT REFERENCES donors(id),
  rms_version VARCHAR(50) DEFAULT '0.0.0', location VARCHAR(255) NOT NULL, isactive BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS laptop_tracking (
  id SERIAL PRIMARY KEY, device_id INT NOT NULL REFERENCES devices(id), total_active_time INT NOT NULL,
  latitude NUMERIC(9,6), longitude NUMERIC(9,6), location_name VARCHAR(255), timestamp TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS softwares (
  id SERIAL PRIMARY KEY,
  software_name VARCHAR(255) NOT NULL,
  winget_id VARCHAR(255) NOT NULL,
  source VARCHAR(255) DEFAULT 'winget',
  is_global BOOLEAN DEFAULT TRUE,
  is_portable BOOLEAN DEFAULT FALSE,
  isactive BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS softwares_installed (
  id SERIAL PRIMARY KEY, device_id INT NOT NULL REFERENCES devices(id), software_name VARCHAR(255) NOT NULL,
  issuccessful BOOLEAN, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS donor_softwares (
  id SERIAL PRIMARY KEY, donor_id INT NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  software_id INT NOT NULL REFERENCES softwares(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (donor_id, software_id)
);
CREATE TABLE IF NOT EXISTS ngo_softwares (
  id SERIAL PRIMARY KEY, ngo_id INT NOT NULL REFERENCES "NGOs"(id) ON DELETE CASCADE,
  software_id INT NOT NULL REFERENCES softwares(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ngo_id, software_id)
);

-- Sample data (fictional)
INSERT INTO donors (donor_name, is_active) VALUES ('Donor A', TRUE), ('Donor B', TRUE), ('Donor C', TRUE);
INSERT INTO "NGOs" ("NGO_name", unique_key, is_active) VALUES ('NGO Pune', 'NGO-PUNE-01', TRUE), ('NGO Dharamshala', 'NGO-DHRM-01', TRUE), ('School 12', 'SCH-12', TRUE);
INSERT INTO devices (username, serial_number, mac_address, ngo_id, donor_id, location) VALUES
 ('student1','PF2X91AB','00:00:00:00:00:01',1,1,'Pune'),('student2','PF2X91AC','00:00:00:00:00:02',1,1,'Pune'),
 ('student3','5CD1234XYZ','00:00:00:00:00:03',2,1,'Dharamshala'),('student4','5CD9999QQQ','00:00:00:00:00:04',3,2,'Delhi');
INSERT INTO softwares (software_name, winget_id, source, is_global, is_portable)
VALUES ('Google Chrome','Google.Chrome','winget',TRUE,FALSE),
       ('AI Tutor','AITutor-Setup-v1.exe','rms-repository',FALSE,FALSE),
       ('Scratch Portable','Scratch.exe','rms-repository',FALSE,TRUE);
INSERT INTO donor_softwares (donor_id, software_id) VALUES (1,2);
INSERT INTO ngo_softwares (ngo_id, software_id) VALUES (1,3);
INSERT INTO softwares_installed (device_id, software_name, issuccessful, created_at) VALUES
 (1,'Google Chrome',TRUE, NOW()-INTERVAL '3 day'),(2,'Google Chrome',TRUE, NOW()-INTERVAL '2 day'),
 (3,'Google Chrome',FALSE,NOW()-INTERVAL '2 day'),(1,'AI Tutor',FALSE,NOW()-INTERVAL '1 day'),
 (2,'AI Tutor',TRUE,NOW()-INTERVAL '5 hour'),(1,'Scratch Portable',TRUE,NOW()-INTERVAL '1 hour');
