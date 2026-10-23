alter table student_document_guidelines drop constraint student_document_guidelines_status_check;
alter table student_document_guidelines add constraint student_document_guidelines_status_check check(status in ('draft','review','published'));
