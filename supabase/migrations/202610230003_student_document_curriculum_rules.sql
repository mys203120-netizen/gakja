alter table student_document_guidelines add column rules jsonb;
alter table student_document_guidelines add constraint student_document_guideline_rules_kind check(rules is null or (kind='curriculum' and jsonb_typeof(rules)='object'));
