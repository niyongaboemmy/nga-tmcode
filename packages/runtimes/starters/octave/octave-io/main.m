% Read one line with two whole numbers, e.g. "3 4".
line = fgetl(stdin);
numbers = sscanf(line, '%d');
printf('Sum: %d\n', numbers(1) + numbers(2));
