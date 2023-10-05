const assert = require('assert')
const plans = require('./plans')

module.exports = {
  rollback,
  next,
  migrate,
  getAll
}

function flatten (schema, commands, version) {
  commands.unshift(plans.assertMigration(schema, version))
  commands.push(plans.setVersion(schema, version))

  return plans.locked(schema, commands)
}

function rollback (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.version === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.uninstall || [], result.previous)
}

function next (schema, version, migrations) {
  migrations = migrations || getAll(schema)

  const result = migrations.find(i => i.previous === version)

  assert(result, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function migrate (value, version, migrations) {
  let schema, config

  if (typeof value === 'string') {
    config = null
    schema = value
  } else {
    config = value
    schema = config.schema
  }

  migrations = migrations || getAll(schema, config)

  const result = migrations
    .filter(i => i.previous >= version)
    .sort((a, b) => a.version - b.version)
    .reduce((acc, i) => {
      acc.install = acc.install.concat(i.install)
      acc.version = i.version
      return acc
    }, { install: [], version })

  assert(result.install.length > 0, `Version ${version} not found.`)

  return flatten(schema, result.install, result.version)
}

function getAll (schema) {
  return [
    {
      release: '10.0.0',
      version: 21,
      previous: 20,
      install: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `DROP INDEX ${schema}.job_singletonOn`,
        `DROP INDEX ${schema}.job_singletonKeyOn`,
        `DROP INDEX ${schema}.job_fetch`,

        `ALTER TABLE ${schema}.job ADD COLUMN deadletter text`,
        `ALTER TABLE ${schema}.job ADD COLUMN policy text`,
        `ALTER TABLE ${schema}.job DROP COLUMN on_complete`,

        // update state enum
        `ALTER TABLE ${schema}.job ALTER COLUMN state TYPE text`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state TYPE text`,

        `DROP TABLE IF EXISTS ${schema}.archive_backup`,
        `ALTER TABLE ${schema}.archive RENAME to archive_backup`,
        `ALTER INDEX ${schema}.archive_archivedon_idx RENAME to archive_backup_archivedon_idx`,

        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created','retry','active','completed','cancelled','failed')`,

        `ALTER TABLE ${schema}.job ALTER COLUMN state TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'::${schema}.job_state`,

        `DELETE FROM ${schema}.job WHERE name LIKE '__pgboss__%'`,

        // set up job partitioning
        `ALTER TABLE ${schema}.job RENAME TO job_default`,
        `ALTER TABLE ${schema}.job_default DROP CONSTRAINT job_pkey`,

        `CREATE TABLE ${schema}.job (
          id uuid not null default gen_random_uuid(),
          name text not null,
          priority integer not null default(0),
          data jsonb,
          state ${schema}.job_state not null default('created'),
          retryLimit integer not null default(0),
          retryCount integer not null default(0),
          retryDelay integer not null default(0),
          retryBackoff boolean not null default false,
          startAfter timestamp with time zone not null default now(),
          startedOn timestamp with time zone,
          singletonKey text,
          singletonOn timestamp without time zone,
          expireIn interval not null default interval '15 minutes',
          createdOn timestamp with time zone not null default now(),
          completedOn timestamp with time zone,
          keepUntil timestamp with time zone NOT NULL default now() + interval '14 days',
          output jsonb,
          deadletter text,
          policy text,
          CONSTRAINT job_pkey PRIMARY KEY (name, id)
        ) PARTITION BY RANGE (name)`,        

        `ALTER TABLE ${schema}.job ATTACH PARTITION ${schema}.job_default DEFAULT`,

        `CREATE TABLE ${schema}.archive (LIKE ${schema}.job)`,
        `ALTER TABLE ${schema}.archive ADD CONSTRAINT archive_pkey PRIMARY KEY (name, id)`,
        `ALTER TABLE ${schema}.archive ADD archivedOn timestamptz NOT NULL DEFAULT now()`,
        `CREATE INDEX archive_archivedon_idx ON ${schema}.archive(archivedon)`,
        `CREATE INDEX archive_name_idx ON ${schema}.archive(name)`,

        `CREATE INDEX job_fetch ON ${schema}.job (name text_pattern_ops, startAfter) INCLUDE (priority, createdOn) WHERE state < 'active'`,
        `CREATE INDEX job_name ON ${schema}.job (name text_pattern_ops)`
        `CREATE UNIQUE INDEX job_policy_short ON ${schema}.job (name) WHERE state = 'created' AND policy = 'short'`,
        `CREATE UNIQUE INDEX job_policy_singleton ON ${schema}.job (name) WHERE state = 'active' AND policy = 'singleton'`,
        `CREATE UNIQUE INDEX job_policy_stately ON ${schema}.job (name, state) WHERE state <= 'active' AND policy = 'stately'`,
        `CREATE UNIQUE INDEX job_throttle_key ON ${schema}.job (name, singletonKey) WHERE state <= 'completed' AND singletonOn IS NULL`,
        `CREATE UNIQUE INDEX job_throttle_on ON ${schema}.job (name, singletonOn, COALESCE(singletonKey, '')) WHERE state <= 'completed' AND singletonOn IS NOT NULL`,
        
        `ALTER TABLE ${schema}.version ADD COLUMN monitored_on timestamp with time zone`,
        
        `CREATE TABLE ${schema}.queue (
          name text primary key,
          policy text,
          retry_limit int,
          retry_delay int,
          retry_backoff bool,
          expire_seconds int,
          retention_minutes int,
          dead_letter text,
          created_on timestamp with time zone not null default now()
        )`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_policy_stately`,
        `DROP INDEX ${schema}.job_policy_short`,
        `DROP INDEX ${schema}.job_policy_singleton`,
        `DROP INDEX ${schema}.job_throttle_on`,
        `DROP INDEX ${schema}.job_throttle_key`,
        `DROP INDEX ${schema}.job_fetch`,
        `DROP INDEX ${schema}.job_name`,
        `ALTER TABLE ${schema}.job DETACH PARTITION ${schema}.job_default`,
        `DROP TABLE ${schema}.job`,
        `ALTER TABLE ${schema}.job_default RENAME TO job`,
        `DROP TABLE IF EXISTS ${schema}.archive_backup`,
        `DROP INDEX ${schema}.archive_archivedon_idx`,
        `DROP INDEX ${schema}.archive_name_idx`,
        `ALTER TABLE ${schema}.job DROP COLUMN deadletter`,
        `ALTER TABLE ${schema}.job DROP COLUMN policy`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state TYPE text`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state DROP DEFAULT`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state TYPE text`,
        `DROP TYPE ${schema}.job_state`,
        `CREATE TYPE ${schema}.job_state AS ENUM ('created','retry','active','completed','expired','cancelled','failed')`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ALTER COLUMN state SET DEFAULT 'created'::${schema}.job_state`,
        `ALTER TABLE ${schema}.job ADD COLUMN on_complete bool NOT NULL DEFAULT false`,
        `ALTER TABLE ${schema}.archive ALTER COLUMN state TYPE ${schema}.job_state USING state::${schema}.job_state`,
        `ALTER TABLE ${schema}.archive DROP COLUMN policy`,
        `ALTER TABLE ${schema}.archive DROP CONSTRAINT archive_pkey`,
        `CREATE INDEX job_fetch ON ${schema}.job (name text_pattern_ops, startAfter) WHERE state < 'active'`,
        `CREATE UNIQUE INDEX job_singletonOn ON ${schema}.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL`,
        `CREATE UNIQUE INDEX job_singletonKeyOn ON ${schema}.job (name, singletonOn, singletonKey) WHERE state < 'expired'`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`,
        `DROP TABLE ${schema}.queue`,
        `ALTER TABLE ${schema}.version DROP COLUMN monitored_on`
      ]
    },
    {
      release: '7.4.0',
      version: 20,
      previous: 19,
      install: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey LIKE '\\_\\_pgboss\\_\\_singleton\\_queue%'`
      ],
      uninstall: [
        `DROP INDEX ${schema}.job_singletonKey`,
        `DROP INDEX ${schema}.job_singleton_queue`,
        `CREATE UNIQUE INDEX job_singletonKey ON ${schema}.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey = '__pgboss__singleton_queue'`,
        `CREATE UNIQUE INDEX job_singleton_queue ON ${schema}.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey = '__pgboss__singleton_queue'`
      ]
    },
    {
      release: '7.0.0',
      version: 19,
      previous: 18,
      install: [
        `CREATE TABLE ${schema}.subscription (
          event text not null,
          name text not null,
          created_on timestamp with time zone not null default now(),
          updated_on timestamp with time zone not null default now(),
          PRIMARY KEY(event, name)
        )`
      ],
      uninstall: [
        `DROP TABLE ${schema}.subscription`
      ]
    }
  ]
}
