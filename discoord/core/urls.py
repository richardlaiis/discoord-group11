from django.contrib.auth import views as auth_views
from django.urls import path
from . import views

urlpatterns = [
    path('groups/create/', views.create_group_view, name='create_group'),
    path('groups/join/', views.join_group_view, name='join_group'),
    path('groups/<slug:slug>/messages/', views.send_message_view, name='send_message'),
    path('groups/<slug:slug>/move/', views.move_member_view, name='move_member'),
    path('groups/<slug:slug>/state/', views.room_state_view, name='room_state'),
    path('groups/<slug:slug>/messages/fragment/', views.group_messages_fragment, name='group_messages_fragment'),
    path('groups/<slug:slug>/members/<int:user_id>/profile/', views.group_member_profile_view, name='group_member_profile'),
    path('groups/<slug:slug>/notes/', views.create_blackboard_note_view, name='create_blackboard_note'),
    path('groups/<slug:slug>/notes/fragment/', views.group_blackboard_fragment, name='group_blackboard_fragment'),
    path('groups/<slug:slug>/notes/<int:note_id>/edit/', views.group_blackboard_note_edit, name='group_blackboard_note_edit'),
    path('groups/<slug:slug>/notes/<int:note_id>/update/', views.update_blackboard_note_view, name='update_blackboard_note'),
    path('groups/<slug:slug>/notes/<int:note_id>/delete/', views.delete_blackboard_note_view, name='delete_blackboard_note'),
    path('groups/<slug:slug>/', views.room_view, name='room_group'),
    path('', views.room_view, name='room'),
    path('login/', views.CustomLoginView.as_view(template_name='registration/login.html'), name='login'),
    path('logout/', views.CustomLogoutView.as_view(), name='logout'),
    path('register/', views.register_view, name='register'),
    path('dm/<int:user_id>/', views.start_dm_view, name='start_dm'),
    path('api/dm/<int:user_id>/', views.get_or_create_dm_api, name='get_or_create_dm_api'),
    path('api/groups/<slug:slug>/drops/', views.group_drops_api, name='group_drops_api'),
    path('api/groups/<slug:slug>/drops/<int:user_id>/', views.user_drop_api, name='user_drop_api'),
]
