-- Run once against the postgres maintenance database, with autocommit enabled.
-- If game_collection already exists, do not drop it: inspect its schema first.
CREATE DATABASE game_collection
    WITH ENCODING = 'UTF8' TEMPLATE = template0;
