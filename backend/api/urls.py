from django.urls import path

from .views import (
    FileContentView,
    FileListUploadView,
    MeView,
    ShareDetailView,
    ShareListCreateView,
    ShareMemberDetailView,
    ShareMembersView,
)

urlpatterns = [
    path('me/', MeView.as_view()),
    path('shares/', ShareListCreateView.as_view()),
    path('shares/<str:name>/', ShareDetailView.as_view()),
    path('shares/<str:name>/members/', ShareMembersView.as_view()),
    path('shares/<str:name>/members/<str:email>/', ShareMemberDetailView.as_view()),
    path('files/<str:namespace>/', FileListUploadView.as_view()),
    path('files/<str:namespace>/content/<path:relative_path>', FileContentView.as_view()),
]
