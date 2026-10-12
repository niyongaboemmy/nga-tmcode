from django.contrib import admin
from django.urls import path

from . import views

urlpatterns = [
    path("", views.home),
    path("api/hello/", views.hello),
    path("admin/", admin.site.urls),
]
