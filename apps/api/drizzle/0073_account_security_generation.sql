-- Existing accounts start at generation zero; only sessions minted after this
-- migration carry that exact value. Legacy Redis sessions have no generation
-- and therefore fail closed instead of being normalized.
ALTER TABLE "users"
ADD COLUMN "security_generation" integer DEFAULT 0 NOT NULL;
