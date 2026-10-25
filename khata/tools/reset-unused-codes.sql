-- Run by go-live.sh right after create-owner.mjs. The temporary "Go-live setup" device took the first block of
-- customer numbers (C-0001..C-0050) and was signed out without using it. While the shop has no customers and no
-- device is signed in, give those numbers back so the first real phone starts at C-0001. Once any customer or live
-- device exists, both statements change nothing.
UPDATE seq SET value = 0
 WHERE name = 'customer_code'
   AND NOT EXISTS (SELECT 1 FROM customers)
   AND NOT EXISTS (SELECT 1 FROM devices WHERE revoked_at IS NULL);
DELETE FROM code_blocks
 WHERE NOT EXISTS (SELECT 1 FROM customers)
   AND NOT EXISTS (SELECT 1 FROM devices WHERE revoked_at IS NULL);
