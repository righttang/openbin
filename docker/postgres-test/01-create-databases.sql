-- The image creates remindme_local_test for manual development first.
-- Each automated suite owns a separate disposable database; keep real data out.
-- This file runs once, on a new local test volume, as the openbin_test role.
CREATE DATABASE openbin_test OWNER openbin_test;
CREATE DATABASE remindme_capture_test OWNER openbin_test;
CREATE DATABASE remindme_migration_test OWNER openbin_test;
