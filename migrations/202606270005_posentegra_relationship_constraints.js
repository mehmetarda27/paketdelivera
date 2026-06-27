module.exports = {
  name: "posentegra_relationship_constraints",
  up({ db, helpers, adapter }) {
    if (helpers.tableExists(db, "restaurants")) {
      helpers.addColumnIfMissing(db, "restaurants", "posentegra_id", "TEXT");
    }
    if (helpers.tableExists(db, "packages")) {
      helpers.addColumnIfMissing(db, "packages", "platform_restaurant_id", "TEXT");
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_posentegra_external
      ON restaurants (posentegra_id)
      WHERE posentegra_id IS NOT NULL AND posentegra_id != '';

      CREATE INDEX IF NOT EXISTS idx_packages_platform_restaurant_id
      ON packages (platform_restaurant_id)
      WHERE platform_restaurant_id IS NOT NULL AND platform_restaurant_id != '';
    `);

    if (adapter !== "postgres") {
      return;
    }

    db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'fk_packages_restaurant_id_restaurants'
            AND conrelid = 'packages'::regclass
        ) THEN
          ALTER TABLE packages
          ADD CONSTRAINT fk_packages_restaurant_id_restaurants
          FOREIGN KEY (restaurant_id)
          REFERENCES restaurants(id)
          NOT VALID;
        END IF;
      END
      $$;
    `);
  },
};
