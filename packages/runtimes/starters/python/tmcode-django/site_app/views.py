from django.http import HttpResponse, JsonResponse


def home(request):
    return HttpResponse("<h1>Django is running</h1><p>Try <a href='/api/hello/'>/api/hello/</a></p>")


def hello(request):
    name = request.GET.get("name", "world")
    return JsonResponse({"message": f"Hello, {name}!"})
