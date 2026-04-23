-- Bundle PR1 (H2): Studio/OpenAPI `TaxIdResponse` reports a single tax ID per
-- org with `{ country, type, value }`. The original table only had type+value,
-- so we add `country` here and let the route handler emit the OpenAPI shape.
--
-- Defaults are permissive so old rows keep working; the UI surfaces and updates
-- `country` explicitly. `country` is not required because historically we
-- persisted rows without one and we still want those to render.

alter table traffic.tax_ids
add column if not exists country text;
