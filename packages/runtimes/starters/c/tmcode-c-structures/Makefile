CFLAGS = -std=c17 -Wall -Wextra -g
OBJ = main.o list.o

app: $(OBJ)
	$(CC) $(CFLAGS) -o app $(OBJ)

%.o: %.c list.h
	$(CC) $(CFLAGS) -c $<

run: app
	./app

clean:
	rm -f app $(OBJ)
