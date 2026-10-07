-- Clip-Shop Flow Dance Loft. Lokal: npx wrangler d1 execute flowdance-clips --local --file schema.sql
-- ponytail: eine Show. Mit der zweiten Show kommt eine Spalte «show» in purchases dazu.

CREATE TABLE IF NOT EXISTS buyers (
  token      TEXT PRIMARY KEY,          -- persönlicher Schlüssel in /k/<token>
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  mailed_at  INTEGER                    -- letzte «Link vergessen»-Mail (höchstens alle 10 Min.)
);
CREATE INDEX IF NOT EXISTS buyers_email ON buyers (email);

-- Eine Zeile pro Clip und Zahlung. Bezahlt hat ein Schlüssel, was auf «confirmed» steht.
CREATE TABLE IF NOT EXISTS purchases (
  id         INTEGER PRIMARY KEY,
  token      TEXT NOT NULL REFERENCES buyers (token),
  clip       INTEGER NOT NULL,          -- Nummer im Line-up
  gateway_id TEXT NOT NULL,             -- Payrexx-Gateway, im Demo-Modus «demo-…»
  status     TEXT NOT NULL DEFAULT 'waiting',   -- waiting, confirmed, refunded
  created_at INTEGER NOT NULL,
  betrag     INTEGER                    -- Betrag der ganzen Zahlung in Rappen, auf jeder Zeile gleich
);
-- Bestehende Datenbanken (07.10.2026): ALTER TABLE purchases ADD COLUMN betrag INTEGER;
CREATE INDEX IF NOT EXISTS purchases_token ON purchases (token);
CREATE INDEX IF NOT EXISTS purchases_gateway ON purchases (gateway_id);
