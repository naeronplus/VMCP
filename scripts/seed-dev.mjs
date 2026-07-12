#!/usr/bin/env node
/**
 * Seed a demo project for local development.
 * Requires DATABASE_URL and a running migrated DB.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL || 'postgresql://pgos:pgos@localhost:5432/pgos';
const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows } = await client.query(
  `INSERT INTO projects (name, slug, godot_version, project_root, high_volume, admin_contacts)
   VALUES ('Demo Godot Project', 'demo', '4.3.1', '/var/godot/projects/demo', false, ARRAY['admin@localhost'])
   ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
   RETURNING id, slug`,
);
console.log('Project:', rows[0]);

await client.query(
  `INSERT INTO extension_policies (extension_id, name, godot_version_range)
   VALUES ('proc-tiles', 'Procedural Tiles', '>=4.2, <4.4')
   ON CONFLICT (extension_id) DO NOTHING`,
);

await client.end();
