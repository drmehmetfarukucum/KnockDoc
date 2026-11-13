-- Optional postdeploy repair if the previous application inserted a request
-- between migration0003 and deployment. No ALTER, deletions or renumbering.
-- Execute all statements together as one D1 batch transaction. Repeatable.
INSERT OR IGNORE INTO daily_visitor_counters(day,last_number)
SELECT created_day,0 FROM requests WHERE visitor_number IS NULL GROUP BY created_day;
UPDATE daily_visitor_counters SET last_number=MAX(last_number,
  COALESCE((SELECT MAX(number) FROM daily_visitors WHERE day=daily_visitor_counters.day),0),
  COALESCE((SELECT MAX(visitor_number) FROM requests WHERE created_day=daily_visitor_counters.day),0)
);
INSERT INTO daily_visitors(day,owner,number,expires)
SELECT pending.created_day,pending.owner,
  daily_visitor_counters.last_number+ROW_NUMBER() OVER (PARTITION BY pending.created_day ORDER BY pending.first_seq),
  pending.expires
FROM (
  SELECT created_day,owner,MIN(seq) AS first_seq,MAX(expires) AS expires FROM requests
  WHERE visitor_number IS NULL
    AND NOT EXISTS(SELECT 1 FROM daily_visitors WHERE day=requests.created_day AND owner=requests.owner)
  GROUP BY created_day,owner
) AS pending JOIN daily_visitor_counters ON daily_visitor_counters.day=pending.created_day;
UPDATE daily_visitors SET expires=MAX(expires,COALESCE((
  SELECT MAX(requests.expires) FROM requests WHERE created_day=daily_visitors.day AND owner=daily_visitors.owner
),expires))
WHERE EXISTS(SELECT 1 FROM requests WHERE created_day=daily_visitors.day AND owner=daily_visitors.owner AND visitor_number IS NULL);
UPDATE daily_visitor_counters SET last_number=MAX(last_number,
  COALESCE((SELECT MAX(number) FROM daily_visitors WHERE day=daily_visitor_counters.day),0)
);
UPDATE requests SET visitor_number=(
  SELECT number FROM daily_visitors WHERE day=requests.created_day AND owner=requests.owner
) WHERE visitor_number IS NULL;
