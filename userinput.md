shoul

can we use one drive or google drive directly as network storage source so that without download we can create virtual albums, also let me know why there is two buttons for scanning photo and scanning faces, if we are scanning remote drive for thumbnail, in same pass we should recognize faces and in case remote storage is not available, thumbnail should be used to show the people album.

when we are doing brackground scanning using network storage, sometime it utilize whole bandwidth, can we add settings

- Maximum bandwidth user per network storage
- Time duration in second between two photo processing

This would help to make evyething responsive and if user working on his desktop, his network storage used for other purpose do not feel slow.

<

need rotate button on photo - list of photo screen on hover of mouse like checkbox for selection appears, When click rotate it should roate thumbnail shown on screen and wait for 2 second so may be user rotate it multiple time, after wait of 2 second, it should be implemented on source file if online and if offline, it has to queue that for when source become online.

also notice 40 second of time required to start the application which is too high, check and improve it by differing un-necessory tasks

Additionally, if I am having 2871 photo in physical folder, face scanning should run on that only but I am observing that it is showing almost double, are face scanning run on thumbnail ? it should run on original picture, for ehic it should generate full resolution jpeg file, run the face recognition and then delete it, for showing to user it should use thumbnail or original photo if storage is available.

In network storage screen, each configured storage should clearly show the progress or status of caching of thumbnail and face detection count. right now jainish is showing face detection status but not thumbnail status and photo1 shows nothing.

Loosing people name is crime as user has done manual input for that so do not loose names anyhow until user click on button reset and rescan.

I recommend to remove overall caching progress section and show that into individual configured storage section only that would serve the purpose .
===================================================================================================================================================

When open network storage it shows nothing configured and then slowely update with actual data, rather than show nothing configured, we should show 'Loading info' until info is actually loaded.

For heic images, we should enable rotate functionality and rorate only thumbnail what we have in our folder to show it properly to user, when user clicks on image and original image is loaded, it might be seen original but that works for now.

Deduplication from selected images, it should treat it as like one cluster and then try to identify best shot between selected images.

Review all code base.

- Check for error handling
- Best code practices
- Improvement for speed and responsiveness to user.
- Keep everything updated and stored whenever some progress is done.
- vusal styling consistant
- Show un-initialized or never loaded info as default stuff, rather should show 'Loading...' or some animation until info is actually loaded.

==

Remove all the 'Google' words as we can not use google word in our application description or name etc, we should use gPhotos everywhere to avoid any  copy right issue.

I try to test creating new network storage location, I have given name 'hemlata' and add it, now it shows two storage location in left side menu called hellata and other with original name of folder which big one. it should be only one.

still virtual rotate is not working for heic files.
Also I need to remove unknown or unnamed person detected from photo in single click, this is very useful when public photo detects lot of person and I know only two or three from them so individual deleting person does not make sense. Also it should store that photo fully manually verified so next face detection pass should not touch that photo and recreate deleted person on that photo until user himself click on scan faces.

When network storage is one drive and I click on folder tree, it shows direct files and in fact dowloading all the file in that structure, we should load thumbnail only and give toggle switch on top whether to load original image if required.,

Yes, now viewing photo shows thumbnail for onedrive backed library but now marking of faces are misplaced at some other location, we have to re-arrange marking.

Also need to check for responsiveness of application as it seems it stalls for few second while background scanning also, can you check and make it asynh and free fronend from lagging, run everything yourself, remove and add same storage and review why main thread is becoming non responsive.

check all the pages for mobile rendering, make button sizing proper for mobile, like photo list have half page of menu and buttons which needs to either make smaller or create button so it will only have one row in top and not fill the half page.

In photo display, show high resolution should be continue to show high resolution photos until it is toggle back, it should not be reseted when prev or next photo button is clicked.

In photo list, In Mobile, when we have select mode, action menu shown is clipped on mobile as shown in screenshot, we need to correct it for mobile display. When we have slection toggle available, we can use that, so when user click on select button, it should remove all other buttons from that group i.e. clean duplicate, rescane everything should be hide until select is toggled back, this will help to provide more space to show selection related buttons. We should redesign selection related button and select toggle itself in one line or max two line.

When user go to album and click on any album, it shows photos in that album, now if user click to open that photo it displa photo in full display. In this veiw application should remember that it is opened from album and when user click next or prev, it should show photos from that album only and not from the library.

- In Album we need image size toolbar similar to photos.
- When open photo, top toolbar is having lot of buttons but all are of different color and shapes, please make it of one shape and meaningful color if required to have colors. Use Icons only and have tooltip to show full meaning of that button icon.
- When open any person, we need buttons to be streamlined in top toolbar with icons only similar to above. Also need button to merge this person with other person.
- When reassigning a person, when we click on new person and write name, it should list or filter people of same name so it helps to prevent duplicate creation like sometime user fail to notice that person is already in list and just click on new person button.

Selection of multiple photo do not work as expected, yes it works for mouse over selection but I need that when we click ctrl button, it should help to add into selection and once photos are selected should not be deselected because of next round of selections.

If image is not having metadata embedded, Image date should be modified date and not the created date as it shows wrong.

We need to find out why albums become empty, even after rescan of folder, it should not changed

===

- In Photo details page
  - Remove top toolbar which shows fav, scan, crop buttons as it is duplicated on top toolbar also.
  - Need editable date time, update file modified time and exif infomation if possible.
  - Place name is editable but it does not update the long,lat or position on map when we modify the place name, it should try to find the location on map and if not found, it should be possible to open the map and set the location on map.
  - Need multiple file selection and update of datetime and location details.
  - Need to show list of album where this photo is added.
  - Need button to add current photo in last added two albums for example if user has added photo in alumn 'Album A' and 'Album B' then need to create button 'Add to Album A' and 'Add to album B'.
  - Tip shown should have button at right most to close it.
- In Albums
  - Albums are shown with no photos even card says 23 photos, for example 'Good Morning' album shows 23 photos but if I click, it do not show any photos.
  - Another observation that if I add one more photo to this album which do not shows photo, it will start showing all the previous photo again.
- In album display page
  - When we click "Add to Album", it shows plain list of photos, here we need different filters like date, location and if possible add 'Filter by AI' to filter photos.
  - When we create or extract cover face, it should be from original photo so that it does not look blur.
- In people and faces page
  - Number of photos below faces are wrong, for example Person 100 card shows 184 photos but when click, it shows 3 photos only.
  - When click on person card, it shows photos of person but when click esc key, it goes back to albums list. All the navigation with esc key should go back to root page which is bind with menu.
  - Sorting of the people should be done based on number of photos and not by name.
  - Only person having more than 2 photo should be listed in this list with optional toggle button in top bar to show all the people.
  - Photos of person screen is having merge button in top toolbar but when click it do not show dialogbox or may be dialog is not on the top.
  - Similarly there should be toogle button to show person with 0 photos.
- Reassign face detection
  - There should be only one big search box and then list of people, user will either directly select the person from list or type and search someone and click on it. If user write something and not found, it should display message that creating new person so both button 'Choose from existing person' and 'Create new person' can be removed.
  - There should be checkbox that 'Merge this person with selected' by which user can directly merge all the photo assigned to selected unknown person to known user, if check box is selected, current Person X's all the photos to be merged with new person and Person X which than have no photos should be removed.

====

![1790096301471](image/userinput/1790096301471.png)

Need timeline in photo galery, may be we can utilize top row where are are showing month and year but you can suggest what best we can do.

In Photo Detail  page, we need button to set this photo as cover photo. On click of this button it should show the face cropped with mark and confirmation button so if user want to adjust crop or sizing of cover photo it can be done and then confirm button to set that portion of photo as cover photo of selected person.
